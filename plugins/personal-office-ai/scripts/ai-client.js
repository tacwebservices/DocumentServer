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
		model: "qwen2.5:7b",
		apiKey: ""
	};
	// A laptop without a graphics card can need minutes for a long answer
	var TIMEOUT_MS = 5 * 60 * 1000;

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
		var controller = new AbortController();
		var timer = setTimeout(function () {
			controller.abort();
		}, TIMEOUT_MS);
		return fetch(settings.url.replace(/\/+$/, "") + "/chat/completions", {
			method: "POST",
			headers: headers,
			signal: controller.signal,
			body: JSON.stringify({
				model: settings.model,
				messages: messages,
				temperature: 0,
				response_format: { type: "json_object" }
			})
		}).then(function (response) {
			return response.json().catch(function () {
				return {};
			}).then(function (data) {
				if (!response.ok)
					throw new Error("The AI service answered: " + ((data.error && data.error.message) || response.status + " " + response.statusText));
				return data;
			});
		}).then(function (data) {
			var choice = data.choices && data.choices[0];
			if (!choice || !choice.message)
				throw new Error("The AI service returned an empty answer.");
			return choice.message.content;
		}, function (error) {
			if (error.name === "AbortError")
				throw new Error("The AI service took more than " + TIMEOUT_MS / 60000 + " minutes. Close other programs to free memory, or use a faster AI server.");
			if (error instanceof TypeError)
				throw new Error("Cannot reach the AI service at " + settings.url + ". Check that it is running.");
			throw error;
		}).finally(function () {
			clearTimeout(timer);
		});
	}

	exports.loadSettings = loadSettings;
	exports.saveSettings = saveSettings;
	exports.chat = chat;
})((window.PersonalOfficeAI = window.PersonalOfficeAI || {}).client = {});
