#!/bin/sh
# SPDX-FileCopyrightText: 2026 Personal Office
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Installs the bundled editor plugins and their v1/plugins.js loader.
# Usage: build.sh <documentserver sdkjs-plugins dir>
#
# The document server lets browsers cache plugin files for a year, so every
# install adds a version to the file addresses to make browsers fetch new ones.
set -eu

out=$1
here=$(cd "$(dirname "$0")" && pwd)
version=$(date +%s)

mkdir -p "$out"
for dir in "$here"/*/; do
	name=$(basename "$dir")
	rm -rf "${out:?}/$name"
	cp -r "$dir" "$out/$name"
	rm -rf "${out:?}/$name/test"
	if [ -f "$out/$name/config.json" ]; then
		sed -i "s|\"url\": \"\([^\"?]*\.html\)\"|\"url\": \"\1?v=$version\"|" "$out/$name/config.json"
	fi
	for page in "$out/$name"/*.html; do
		[ -f "$page" ] || continue
		sed -i "s/\(\(src\|href\)=\"[^\":?]*\.\(js\|css\)\)\"/\1?v=$version\"/g" "$page"
	done
done
