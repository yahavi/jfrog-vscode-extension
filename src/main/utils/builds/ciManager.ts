import * as vscode from 'vscode';
import { TreesManager } from '../../treeDataProviders/treesManager';
import { Configuration } from '../configuration';
import { IAqlSearchResult, IArtifact, IDetailsResponse, IGeneral, IIssue, ILicense, ISearchEntry, JfrogClient } from 'jfrog-client-js';
import PQueue from 'p-queue';
import { BuildGeneralInfo } from '../../types/buildGeneralinfo';
import { BuildsUtils } from './buildsUtils';
import { BuildsScanCache, Type } from './buildsScanCache';
import { ConnectionUtils } from '../../connect/connectionUtils';
import { SemVer } from 'semver';
import { DependenciesTreeNode } from '../../treeDataProviders/dependenciesTree/dependenciesTreeNode';
import { BuildsNode } from '../../treeDataProviders/dependenciesTree/dependenciesRoot/buildsTree';
import { GeneralInfo } from '../../types/generalInfo';
import { Dependency } from '../../types/dependency';
import * as Collections from 'typescript-collections';
import { Issue } from '../../types/issue';
import { Translators } from '../translators';
import { Severity } from '../../types/severity';

/**
 * Manage the filters of the components tree.
 */
export class CiManager {
    private static readonly BUILD_INFO_REPO: string = '/artifactory-build-info/';
    private static readonly DISPLAY_BUILDS_NUM: string = '3'; // todo revert to 100
    public static readonly MINIMAL_XRAY_VERSION_SUPPORTED_FOR_CI: string = '3.21.2';
    public static readonly CI_CANCELLATION_ERROR: Error = new Error('Loading builds scan cancelled');

    private readonly buildsCache: BuildsScanCache;
    private root: DependenciesTreeNode;

    constructor(private _treesManager: TreesManager, root?: DependenciesTreeNode) {
        this.buildsCache = new BuildsScanCache('projectNAME', this._treesManager.logManager); // todo project name
        if (!root) {
            this.root = new DependenciesTreeNode(new GeneralInfo('', '', [], '', ''));
        } else {
            this.root = root;
        }
    }

    public loadBuildTree(buildName: string, buildNumber: string, parent: DependenciesTreeNode) {
        const build: any = this.buildsCache.loadBuildInfo(buildName, buildNumber);
        if (!build) {
            throw new Error(`Couldn't find build info object in cache for '${buildName}/${buildNumber}'.`);
        }

        let bgi: BuildGeneralInfo = BuildsUtils.createBuildGeneralInfo(build, this._treesManager.logManager);
        const buildTree: BuildsNode = new BuildsNode(bgi);
        parent.addChild(buildTree);
        const modulesTree: DependenciesTreeNode = new DependenciesTreeNode(
            new GeneralInfo('modules', '', [], '', ''),
            vscode.TreeItemCollapsibleState.Expanded,
            parent
        );
        if (!!build.modules) {
            this.populateModulesDependencyTree(build, modulesTree);
        }

        // If the build was scanned by Xray, load Xray 'details/build' response from cache.
        let detailsResponse: IDetailsResponse | null = this.buildsCache.loadScanResults(buildName, buildNumber);
        this.populateBuildDependencyTree(detailsResponse, modulesTree);
    }

    public populateModulesDependencyTree(build: any, node: DependenciesTreeNode) {
        for (const module of build.modules) {
            const artifactId: string = BuildsUtils.getArtifactIdFromCompId(module.id);
            const version: string = BuildsUtils.getVersionFromCompId(module.id);
            const moduleGeneralInfo: GeneralInfo = new GeneralInfo(artifactId, version, [], '', module.type);
            const moduleNode: DependenciesTreeNode = new DependenciesTreeNode(moduleGeneralInfo, vscode.TreeItemCollapsibleState.Collapsed);

            // Populate artifacts
            const artifactsNode: DependenciesTreeNode = BuildsUtils.createArtifactsNode();
            moduleNode.addChild(artifactsNode);
            if (!!module.artifacts) {
                this.populateArtifacts(artifactsNode, module);
            }

            // Populate dependencies
            const dependenciesNode: DependenciesTreeNode = BuildsUtils.createDependenciesNode();
            moduleNode.addChild(dependenciesNode);
            if (!!module.artifacts) {
                this.populateDependencies(dependenciesNode, module);
            }

            node.addChild(moduleNode);
        }
    }

    public populateArtifacts(artifactsNode: DependenciesTreeNode, module: any): void {
        for (const artifact of module.artifacts) {
            const artifactGeneralInfo: GeneralInfo = new GeneralInfo(artifact.name, '', [], '', artifact.type, artifact.sha1, artifact.sha256);
            const artifactNode: DependenciesTreeNode = new DependenciesTreeNode(artifactGeneralInfo, vscode.TreeItemCollapsibleState.None);
            artifactsNode.addChild(artifactNode);
        }
    }

    public populateDependencies(dependenciesNode: DependenciesTreeNode, module: any): void {
        let directDependencies: Set<Dependency> = new Set<Dependency>();
        let parentToChildren: Map<string, Dependency[]> = new Map<string, Dependency[]>();

        let dependencies: any = module.dependencies;
        if (!dependencies) {
            return;
        }
        for (const dependency of dependencies) {
            let requestedBy: string[][] = dependency.requestedBy;
            if (!requestedBy || !requestedBy[0]) {
                directDependencies.add(dependency);
                continue;
            }

            for (const parent of requestedBy) {
                let directParent: string = parent[0];
                if (!requestedBy[0][0] || requestedBy[0][0] === module.id) {
                    directDependencies.add(dependency);
                } else {
                    let children: Dependency[] = parentToChildren.get(directParent) || [];
                    children.push(dependency);
                    parentToChildren.set(directParent, children);
                }
            }
        }

        for (const directDependency of directDependencies) {
            dependenciesNode.addChild(this.populateTransitiveDependencies(directDependency, parentToChildren));
        }
    }

    private populateTransitiveDependencies(dependency: Dependency, parentToChildren: Map<string, Dependency[]>): DependenciesTreeNode {
        let dependencyGeneralInfo: GeneralInfo = new GeneralInfo(
            dependency.id,
            '',
            dependency.scopes,
            '',
            dependency.type,
            dependency.sha1,
            dependency.sha256
        );
        let dependencies: Dependency[] = parentToChildren.get(dependency.id) || [];
        let dependencyTree: DependenciesTreeNode = new DependenciesTreeNode(
            dependencyGeneralInfo,
            dependencies.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
        );

        for (const child of dependencies) {
            dependencyTree.addChild(this.populateTransitiveDependencies(child, parentToChildren));
        }
        return dependencyTree;
    }

    public populateBuildDependencyTree(response: IDetailsResponse | null, modulesTree: DependenciesTreeNode): void {
        if (!response) {
            // If no response from Xray, the dependency tree components status is unknown.
            // Populate all nodes with dummy unknown level issues to show the unknown icon in tree nodes.
            this.populateTreeWithUnknownIssues(modulesTree);
            return;
        }

        // Component to issues and licenses mapping
        let componentIssuesAndLicenses: Map<string, IssuesAndLicensesPair> = new Map();
        // Sha1 to Sha256 mapping
        let sha1ToSha256: Map<string, string> = new Map();
        // Component to Xray Artifact mapping
        let sha1ToComponent: Map<string, IArtifact> = new Map();

        // Populate the above mappings. We will use the information to populate the dependency tree efficiently.
        let components: IArtifact[] = response.components;
        for (const component of components) {
            let general: IGeneral = component.general;
            sha1ToComponent.set(general.sha1, component);
            sha1ToSha256.set(general.sha1, general.sha256);
            for (const parentSha256 of general.parent_sha256) {
                let issuesAndLicenses: IssuesAndLicensesPair | undefined = componentIssuesAndLicenses.get(parentSha256);
                if (!issuesAndLicenses) {
                    issuesAndLicenses = new IssuesAndLicensesPair();
                }
                if (component.issues.length > 0) {
                    for (const issue of component.issues) {
                        issuesAndLicenses._issues.add(issue);
                    }
                }
                if (component.licenses.length > 0) {
                    for (const license of component.licenses) {
                        issuesAndLicenses._licenses.add(license);
                    }
                }
            }
        }

        // Populate the build modules
        for (const module of modulesTree.children) {
            for (const artifactsOrDep of module.children) {
                const isArtifactNode: boolean = artifactsOrDep.generalInfo.artifactId === BuildsUtils.ARTIFACTS_NODE;
                for (const child of artifactsOrDep.children) {
                    this.populateComponents(child, sha1ToComponent, sha1ToSha256, componentIssuesAndLicenses, isArtifactNode);
                }
            }
            module.issues = module.processTreeIssues();
        }
    }

    public populateComponents(
        node: DependenciesTreeNode,
        sha1ToComponent: Map<string, IArtifact>,
        sha1ToSha256: Map<string, string>,
        componentIssuesAndLicenses: Map<string, IssuesAndLicensesPair>,
        isArtifact: boolean
    ): void {
        for (const child of node.children) {
            this.populateComponents(child, sha1ToComponent, sha1ToSha256, componentIssuesAndLicenses, isArtifact);
        }
        let sha1: string | undefined = node.generalInfo.sha1;
        if (!sha1) {
            // Sha1 does not exist in node
            return;
        }
        let artifact: IArtifact | undefined = sha1ToComponent.get(sha1);
        if (!artifact) {
            // Artifact not found in Xray scan
            return;
        }
        if (artifact.issues.length > 0) {
            for (const issue of artifact.issues) {
                node.issues.add(Translators.toIssue(issue));
            }
        }
        if (artifact.licenses.length > 0) {
            for (const license of artifact.licenses) {
                node.licenses.add(Translators.toLicense(license));
            }
        }
        if (!isArtifact) {
            return;
        }
        let sha256: string = sha1ToSha256.get(sha1)!;
        let issuesAndLicenses: IssuesAndLicensesPair | undefined = componentIssuesAndLicenses.get(sha256);
        if (issuesAndLicenses) {
            issuesAndLicenses._issues.forEach(issue => {
                node.issues.add(Translators.toIssue(issue));
            });
            issuesAndLicenses._licenses.forEach(license => {
                node.licenses.add(Translators.toLicense(license));
            });
        }
    }

    public populateTreeWithUnknownIssues(modulesTree: DependenciesTreeNode) {
        for (const node of modulesTree.children) {
            node.issues.add(new Issue('', Severity.Unknown, '', ''));
        }
    }

    public async refreshBuilds(progress: vscode.Progress<{ message?: string; increment?: number }>, checkCanceled: () => void): Promise<void> {
        const pattern: string = Configuration.getBuildsPattern();
        try {
            await this.buildCiTree(pattern, progress, checkCanceled);
        } catch (error) {
            vscode.window.showErrorMessage('Could not build CI tree.', <vscode.MessageOptions>{ modal: false });
            this._treesManager.logManager.logMessage(error.stdout.toString(), 'ERR', true);
        }
    }

    private async buildCiTree(
        buildsPattern: string,
        progress: vscode.Progress<{ message?: string; increment?: number }>,
        checkCanceled: () => void
    ): Promise<void> {
        try {
            const searchResult: IAqlSearchResult = await this._treesManager.connectionManager.searchArtifactsByAql(
                CiManager.createAqlForBuildArtifacts(buildsPattern)
            );
            if (!searchResult.results) {
                return;
            }
            progress.report({ message: `${searchResult.results.length} builds` });

            const producerQueue: PQueue = new PQueue({ concurrency: 1 });
            const consumerQueue: PQueue = new PQueue({ concurrency: 1 });
            for (const entry of searchResult.results) {
                checkCanceled();
                await producerQueue.add(() =>
                    this.getBuildInfoAndProduce(entry, consumerQueue, this.buildsCache, progress, checkCanceled, searchResult.results.length)
                );
            }
        } catch (error) {
            if (error.message === CiManager.CI_CANCELLATION_ERROR.message) {
                // If it's not a cancellation error, throw it up
                throw error;
            }
            vscode.window.showErrorMessage(error.toString());
        }
    }

    private async getBuildInfoAndProduce(
        searchEntry: ISearchEntry,
        consumerQueue: PQueue,
        buildsCache: BuildsScanCache,
        progress: vscode.Progress<{ message?: string; increment?: number }>,
        checkCanceled: () => void,
        buildsNum: number
    ): Promise<void> {
        try {
            checkCanceled();
            const buildName: string = decodeURIComponent(searchEntry.path); // todo decode?
            const buildNumber: string = searchEntry.name.split('-', 1)[0];

            let build: any = buildsCache.loadBuildInfo(buildName, buildNumber);
            if (!build) {
                build = await this.downloadBuildInfo(searchEntry, buildsCache);
            }
            if (!build) {
                return;
            }
            await consumerQueue.add(() =>
                this.handleXrayBuildDetails(
                    BuildsUtils.createBuildGeneralInfo(build, this._treesManager.logManager),
                    buildsCache,
                    progress,
                    checkCanceled,
                    buildsNum
                )
            );
            console.log(build);
        } catch (error) {
            if (error.message === CiManager.CI_CANCELLATION_ERROR.message) {
                // If it's not a cancellation error, throw it up
                throw error;
            }
            vscode.window.showErrorMessage('Could not download build info.', <vscode.MessageOptions>{ modal: false });
            this._treesManager.logManager.logMessage(error.stdout.toString(), 'ERR', true);
        } finally {
            progress.report({ message: `${buildsNum} builds`, increment: (1 / buildsNum) * 2 * 100 });
        }
    }

    private async downloadBuildInfo(searchEntry: ISearchEntry, buildsCache: BuildsScanCache): Promise<any> {
        const artifactPath: string = CiManager.BUILD_INFO_REPO + searchEntry.path + '/' + searchEntry.name;
        try {
            const build: any = await this._treesManager.connectionManager.downloadArtifact(artifactPath); // todo JSON.parse?
            buildsCache.save(JSON.stringify(build), build.name, build.number, Type.BUILD_INFO);
            return build;
        } catch (error) {
            this._treesManager.logManager.logMessage("Couldn't retrieve build information", 'ERR', true);
        }
    }

    private async downloadBuildDetails(buildGeneralInfo: BuildGeneralInfo, buildsCache: BuildsScanCache): Promise<void> {
        const detailsResponse: IDetailsResponse = await this._treesManager.connectionManager.downloadBuildDetails(
            buildGeneralInfo.artifactId,
            buildGeneralInfo.version
        );
        if (!detailsResponse.is_scan_completed || !!detailsResponse.error_details || !detailsResponse.components) {
            if (!!detailsResponse.error_details) {
                this._treesManager.logManager.logMessage('Could not get build details: ' + detailsResponse.error_details.error_message, 'ERR', true);
            }
            return;
        }
        buildsCache.save(JSON.stringify(detailsResponse), buildGeneralInfo.artifactId, buildGeneralInfo.version, Type.BUILD_SCAN_RESULTS);
    }

    private addResults(bgi: BuildGeneralInfo): void {
        const buildTree: BuildsNode = new BuildsNode(bgi);
        this.root.addChild(buildTree); // todo mutex / sync
    }

    private async handleXrayBuildDetails(
        buildGeneralInfo: BuildGeneralInfo,
        buildsCache: BuildsScanCache,
        progress: vscode.Progress<{ message?: string; increment?: number }>,
        checkCanceled: () => void,
        buildsNum: number
    ): Promise<void> {
        try {
            if (!(await this.isXraySupportedForCI())) {
                return;
            }
            const buildName: string = buildGeneralInfo.artifactId;
            const buildNumber: string = buildGeneralInfo.version;
            checkCanceled();
            if (!buildsCache.loadScanResults(buildName, buildNumber)) {
                await this.downloadBuildDetails(buildGeneralInfo, buildsCache);
            }
        } catch (error) {
            if (error.message === CiManager.CI_CANCELLATION_ERROR.message) {
                // If it's not a cancellation error, throw it up
                throw error;
            }
            this._treesManager.logManager.logMessage('Could not get build details from xray: ' + error.stdout.toString(), 'ERR', true);
        } finally {
            this.addResults(buildGeneralInfo);
            progress.report({ message: `${buildsNum} builds`, increment: (1 / buildsNum) * 2 * 100 });
        }
    }

    private static createAqlForBuildArtifacts(buildsPattern: string): string {
        return `items.find({
        \"repo\":\"artifactory-build-info\",
        \"path\":{\"$match\":\"${buildsPattern}\"}})
        .include(\"name\",\"repo\",\"path\",\"created\")
        .sort({\"$desc\":[\"created\"]})
        .limit(${CiManager.DISPLAY_BUILDS_NUM})`;
    }

    private async isXraySupportedForCI(): Promise<boolean> {
        const jfrogClient: JfrogClient = this._treesManager.connectionManager.createJfrogClient();
        let xrayVersion: string = await ConnectionUtils.getXrayVersion(jfrogClient);
        return await ConnectionUtils.isXrayVersionCompatible(xrayVersion, new SemVer(CiManager.MINIMAL_XRAY_VERSION_SUPPORTED_FOR_CI));
    }
}

class IssuesAndLicensesPair {
    public _issues: Collections.Set<IIssue> = new Collections.Set<IIssue>();
    public _licenses: Collections.Set<ILicense> = new Collections.Set<ILicense>();
}
