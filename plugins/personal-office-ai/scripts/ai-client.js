/*
 * SPDX-FileCopyrightText: 2026 Personal Office
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Talks to any OpenAI-compatible chat endpoint: Ollama on the laptop,
 * or llama.cpp / vLLM on an AI Box.
 */
(function (exports) {
	"use strict";

	var STORAGE_KEY = "personal-office-ai.settings";
	var DEFAULTS = {
		url: "http://localhost:11434/v1",
		model: "gpt-oss:20b",
		apiKey: ""
	};

	function loadSettings() {
		var saved = {};
		try {
			saved = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
		} catch (e) {}
		return {
			url: saved.url || DEFAULTS.url,
			model: saved.model || DEFAULTS.model,
			apiKey: saved.apiKey || DEFAULTS.apiKey
		};
	}

	function saveSettings(settings) {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
		} catch (e) {}
	}

	function chat(settings, messages) {
		var headers = { "Content-Type": "application/json" };
		if (settings.apiKey)
			headers.Authorization = "Bearer " + settings.apiKey;
		return fetch(settings.url.replace(/\/+$/, "") + "/chat/completions", {
			method: "POST",
			headers: headers,
			body: JSON.stringify({
				model: settings.model,
				messages: messages,
				temperature: 0,
				reasoning_effort: "low",
				response_format: { type: "json_object" }
			})
		}).then(function (response) {
			if (!response.ok)
				throw new Error("The AI service answered " + response.status + " " + response.statusText);
			return response.json();
		}).then(function (data) {
			var choice = data.choices && data.choices[0];
			if (!choice || !choice.message)
				throw new Error("The AI service returned an empty answer.");
			return choice.message.content;
		}, function (error) {
			if (error instanceof TypeError)
				throw new Error("Cannot reach the AI service at " + settings.url + ". Check that it is running.");
			throw error;
		});
	}

	exports.loadSettings = loadSettings;
	exports.saveSettings = saveSettings;
	exports.chat = chat;
})((window.PersonalOfficeAI = window.PersonalOfficeAI || {}).client = {});
