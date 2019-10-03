const github = require('@actions/github');
const core = require('@actions/core');
const fs = require('fs');

let tag = process.env.GITHUB_REF.split('/')[2];
let vsixFileName = 'jfrog-vscode-extension-' + tag + '.vsix';
core.debug('Uploading ' + vsixFileName);

let vsixFilePath = '../' + vsixFileName;
const octokit = new github.GitHub(process.env.GITHUB_TOKEN);

octokit.repos
    .getRelease({
        owner: 'yahavi',
        repo: 'jfrog-vscode-extension',
        release_id: tag
    })
    .then(url => {
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
