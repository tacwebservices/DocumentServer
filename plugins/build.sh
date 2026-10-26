#!/bin/sh
# SPDX-FileCopyrightText: 2026 Personal Office
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Installs the bundled editor plugins and their v1/plugins.js loader.
# Usage: build.sh <documentserver sdkjs-plugins dir>
set -eu

out=$1
here=$(cd "$(dirname "$0")" && pwd)

mkdir -p "$out"
for dir in "$here"/*/; do
	name=$(basename "$dir")
	rm -rf "${out:?}/$name"
	cp -r "$dir" "$out/$name"
	rm -rf "${out:?}/$name/test"
done
