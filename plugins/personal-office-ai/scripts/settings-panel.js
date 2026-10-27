/*
 * SPDX-FileCopyrightText: 2026 Personal Office
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The "AI connection" settings, shared by the Personal Office panels.
 * Expects #settings, #setting-service, #setting-cloud-note, #setting-url,
 * #setting-model, #setting-key and #save-settings in the page.
 */
(function (exports) {
	"use strict";

	var client = window.PersonalOfficeAI.client;

	function $(id) {
		return document.getElementById(id);
	}

	function showCloudNote() {
		var service = $("setting-service").value;
		$("setting-cloud-note").hidden = service !== "openai" && service !== "claude";
	}

	function changeService() {
		var service = client.SERVICES[$("setting-service").value];
		$("setting-url").value = service.url;
		$("setting-model").value = service.model;
		showCloudNote();
	}

	function show() {
		var s = client.loadSettings();
		var select = $("setting-service");
		if (!select.options.length) {
			Object.keys(client.SERVICES).forEach(function (key) {
				select.add(new Option(client.SERVICES[key].name, key));
			});
		}
		select.value = s.service;
		showCloudNote();
		$("setting-url").value = s.url;
		$("setting-model").value = s.model;
		$("setting-key").value = s.apiKey;
	}

	// onSaved is called after saving, to tell the user.
	function init(onSaved) {
		$("settings").ontoggle = show;
		$("setting-service").onchange = changeService;
		$("save-settings").onclick = function () {
			client.saveSettings({
				service: $("setting-service").value,
				url: $("setting-url").value.trim(),
				model: $("setting-model").value.trim(),
				apiKey: $("setting-key").value.trim()
			});
			onSaved();
		};
	}

	exports.init = init;
})((window.PersonalOfficeAI = window.PersonalOfficeAI || {}).settingsPanel = {});
