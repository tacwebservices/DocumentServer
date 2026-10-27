#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Personal Office
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Installs the bundled editor plugins into the desktop editors.
# Usage: install.py <sdkjs-plugins dir>
#   - <DesktopEditors>/editors/sdkjs-plugins, when building the app, or
#   - %APPDATA%/.../data/sdkjs-plugins of an installed app (user plugins).
#
# The desktop editors find a plugin by its GUID, so each plugin goes in a
# folder named after it, and links between plugins ("../personal-office-ai/")
# are rewritten to those folder names. The desktop keeps its own v1 loader.
import json
import os
import re
import shutil
import sys


def plugin_guid(config_path):
    with open(config_path, encoding="utf-8") as f:
        guid = json.load(f)["guid"]
    match = re.fullmatch(r"asc\.(\{[0-9A-Fa-f-]+\})", guid)
    if not match:
        raise ValueError(config_path + ": unexpected guid " + guid)
    return match.group(1)


def main(out):
    here = os.path.dirname(os.path.abspath(__file__))
    plugins = {}
    for name in sorted(os.listdir(here)):
        config = os.path.join(here, name, "config.json")
        if os.path.isfile(config):
            plugins[name] = plugin_guid(config)

    os.makedirs(out, exist_ok=True)
    for name, guid in plugins.items():
        target = os.path.join(out, guid)
        shutil.rmtree(target, ignore_errors=True)
        shutil.copytree(os.path.join(here, name), target, ignore=shutil.ignore_patterns("test"))
        for page in os.listdir(target):
            if not page.endswith(".html"):
                continue
            path = os.path.join(target, page)
            with open(path, encoding="utf-8", newline="") as f:
                html = f.read()
            for other, other_guid in plugins.items():
                html = html.replace('"../' + other + "/", '"../' + other_guid + "/")
            with open(path, "w", encoding="utf-8", newline="") as f:
                f.write(html)
        print("installed " + name + " as " + guid)

    loader = os.path.join(out, "v1", "plugins.js")
    if not os.path.isfile(loader):
        os.makedirs(os.path.dirname(loader), exist_ok=True)
        shutil.copy(os.path.join(here, "v1", "plugins.js"), loader)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: install.py <sdkjs-plugins dir>")
    main(sys.argv[1])
