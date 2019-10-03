const github = require('@actions/github');
const core = require('@actions/core')
const fs = require('fs');

const githubToken = core.getInput('GITHUB_TOKEN');
const octokit = new github.GitHub(githubToken);

let vsixFileName = 'jfrog-vscode-extension-' + process.argv[1] + '.vsix';
let vsixFilePath = '../' + vsixFileName;

octokit.repos.uploadReleaseAsset({
    file: fs.createReadStream(vsixFilePath),
    headers: {
        'content-length': fs.statSync(vsixFilePath).size,
        'content-type': 'application/zip'
    },
    name: vsixFileName,
    url: 'https://uploads.github.com/repos/yahavi/jfrog-vscode-extension/releases/' + process.argv[j] + '/assets{?name,label}'
});
