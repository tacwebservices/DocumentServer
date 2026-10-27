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

	function gigabytes(bytes) {
		return (bytes / 1e9).toFixed(1);
	}

	// When error says the local model is missing, shows a button under the
	// status to download it once (never automatically: it is many gigabytes).
	// Returns true when it handled the error.
	function offerModelDownload(error, setStatus) {
		if (!error || error.code !== "model-missing")
			return false;
		var settings = client.loadSettings();
		var box = $("model-download");
		if (!box) {
			box = document.createElement("div");
			box.id = "model-download";
			box.className = "actions";
			$("status").insertAdjacentElement("afterend", box);
		}
		box.textContent = "";
		var button = document.createElement("button");
		button.className = "btn-text-default primary";
		button.textContent = "Download AI model";
		box.appendChild(button);
		box.hidden = false;
		setStatus(error.message + " Download it once (" + (settings.model.indexOf("gpt-oss") === 0 ? "about 13 GB" : "several GB") +
			", needs internet); after that it works offline.", "error");
		button.onclick = function () {
			button.disabled = true;
			setStatus("Starting the download…");
			client.pullModel(settings, function (completed, total, status) {
				setStatus(total ? "Downloading the AI model… " + Math.floor(completed / total * 100) + "% (" + gigabytes(completed) + " of " + gigabytes(total) + " GB)" :
					"Downloading the AI model… " + status);
			}).then(function () {
				box.hidden = true;
				setStatus("The AI model is ready. Try again.", "ok");
			}, function (e) {
				button.disabled = false;
				button.textContent = "Try the download again";
				setStatus(e.message.replace(/([^.])$/, "$1.") + " The part already downloaded is kept.", "error");
			});
		};
		return true;
	}

	exports.init = init;
	exports.offerModelDownload = offerModelDownload;
})((window.PersonalOfficeAI = window.PersonalOfficeAI || {}).settingsPanel = {});
