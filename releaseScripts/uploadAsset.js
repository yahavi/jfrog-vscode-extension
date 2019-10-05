const github = require('@actions/github');
const core = require('@actions/core');
const fs = require('fs');

const tag = process.env.GITHUB_REF.split('/')[2];
const octokit = new github.GitHub(process.env.GITHUB_TOKEN);
octokit.repos
    .listReleases({
        owner: 'yahavi',
        repo: 'jfrog-vscode-extension'
    })
    .then(releases => {
        const release = releases.data.find(release => release.tag_name === tag);
        const vsixFileName = 'jfrog-vscode-extension-' + tag + '.vsix';
        const vsixFilePath = '../' + vsixFileName;
        core.info('Uploading ' + vsixFileName);
        return octokit.repos.uploadReleaseAsset({
            file: fs.createReadStream(vsixFilePath),
            mediaType: 'application/zip',
            headers: {
                'content-length': fs.statSync(vsixFilePath).size,
            },
            name: vsixFileName,
            url: release.uploadUrl
        });
    })
    .then(() => {
        core.info('Asset uploaded successfully');
    })
    .catch(error => {
        core.error(error);
    });
