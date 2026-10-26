# SPDX-FileCopyrightText: 2026 Personal Office
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Quick Personal Office image: the released document server plus our plugins.
# Build from this folder: docker build -t personal-office/documentserver plugins
ARG BASE_IMAGE=ghcr.io/euro-office/documentserver:latest
FROM ${BASE_IMAGE}

COPY . /tmp/plugins
RUN sh /tmp/plugins/build.sh /var/www/euro-office/documentserver/sdkjs-plugins \
	&& rm -rf /tmp/plugins
