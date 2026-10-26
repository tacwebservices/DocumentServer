/*
 * SPDX-FileCopyrightText: 2026 Personal Office
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Plugin loader. The editor sends the plugin API code (sdkjs/common/plugins)
 * in reply to "initialize", so it always matches the running editor version.
 */
(function (window) {
	"use strict";

	window.Asc = window.Asc || {};
	window.Asc.plugin = window.Asc.plugin || {};
	window.Asc.scope = window.Asc.scope || {};

	var xhr = new XMLHttpRequest();
	xhr.open("GET", "./config.json", false);
	xhr.send();
	window.Asc.plugin.guid = JSON.parse(xhr.responseText).guid;

	var windowID = new URLSearchParams(window.location.search).get("windowID");
	if (windowID)
		window.Asc.plugin.windowID = windowID;

	window.addEventListener("message", function (event) {
		if (typeof event.data !== "string")
			return;
		var message;
		try {
			message = JSON.parse(event.data);
		} catch (e) {
			return;
		}
		if (message.type === "plugin_init") {
			if (message.guid === window.Asc.plugin.guid && !window.plugin_onMessage)
				(0, eval)(message.data);
			return;
		}
		if (window.plugin_onMessage)
			window.plugin_onMessage(event);
	});

	// Wait for the plugin's own scripts, which set Asc.plugin.init
	window.addEventListener("load", function () {
		var start = { guid: window.Asc.plugin.guid, type: "initialize" };
		if (windowID)
			start.windowID = windowID;
		window.parent.postMessage(JSON.stringify(start), "*");
	});
})(window);
