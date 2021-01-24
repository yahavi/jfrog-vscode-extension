#!/usr/bin/env python
import os
import json
import sys
import subprocess

import conda.exports


def main():
    _info = json.loads(subprocess.check_output(
        ['conda', 'info', '-e', '--json']))

    prefix = _info['active_prefix'] if not None else _info['default_prefix']

    packages = conda.exports.linked_data(prefix)
    packagesKeys = packages.keys()
    results = "["
    for i, key in enumerate(packagesKeys):
        dependencies = ""
        for dependency in packages[key]['depends']:
            dependencies += "\"" + dependency.partition(' ')[0] + "\","
        if dependencies != "":
            dependencies = dependencies[:-1]

        lastComma = "," if i < len(packagesKeys) - 1 else ""
        results += "{\"name\":\"" + packages[key]['name'] + "\"" + ",\"version\":\"" + packages[key]['version'] + \
            "\",\"dependencies\":[" + dependencies + "]}" + lastComma
    print(results + "]")


if __name__ == "__main__":
    main()
