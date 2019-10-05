const github = require('@actions/github');
const core = require('@actions/core');
const fs = require('fs');

let tag = process.env.GITHUB_REF.split('/')[2];
let vsixFileName = 'jfrog-vscode-extension-' + tag + '.vsix';
core.info('Uploading ' + vsixFileName);

let vsixFilePath = '../' + vsixFileName;
const octokit = new github.GitHub(process.env.GITHUB_TOKEN);

core.info('vsixFilePath exist: ' + fs.existsSync(vsixFilePath));
core.info('vsixFileName exist: ' + fs.existsSync(vsixFileName));

octokit.repos
    .listReleases({
        owner: 'yahavi',
        repo: 'jfrog-vscode-extension'
    })
    .then(releases => {
        core.info('releases: ' + releases);
        let release = releases.data.find(release => release.tag_name === tag);
        core.info('release_id: ' + JSON.stringify(release));
        octokit.repos.getRelease({
            owner: 'yahavi',
            repo: 'jfrog-vscode-extension',
            release_id: release.id
        });
    })
    .then(url => {
        core.info('Uploading url: ' + url);
        octokit.repos.uploadReleaseAsset({
            file: fs.createReadStream(vsixFilePath),
            headers: {
                'content-length': fs.statSync(vsixFilePath).size,
                'content-type': 'application/zip'
            },
            name: vsixFileName,
            url: url
        });
    })
    .catch(error => {
        core.error(error);
    });
