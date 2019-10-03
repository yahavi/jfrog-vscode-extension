const github = require('@actions/github');
const core = require('@actions/core');
const fs = require('fs');

const githubToken = core.getInput('GITHUB_TOKEN', { required: true });
const octokit = new github.GitHub(githubToken);

let tag = process.env.GITHUB_REF.split('/')[2];
core.debug('Releasing ' + tag);

let vsixFileName = 'jfrog-vscode-extension-' + tag + '.vsix';
let vsixFilePath = '../' + vsixFileName;

octokit.repos
    .uploadReleaseAsset({
        file: fs.createReadStream(vsixFilePath),
        headers: {
            'content-length': fs.statSync(vsixFilePath).size,
            'content-type': 'application/zip'
        },
        name: vsixFileName,
        url: 'https://uploads.github.com/repos/yahavi/jfrog-vscode-extension/releases/' + tag + '/assets{?name,label}'
    })
    .catch(error => {
        core.error(error);
    });
