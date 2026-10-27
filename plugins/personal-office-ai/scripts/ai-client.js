/*
 * SPDX-FileCopyrightText: 2026 Personal Office
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Talks to the AI service chosen in the panel: Ollama on the laptop, an AI Box
 * (llama.cpp / vLLM), ChatGPT (OpenAI) or Claude (Anthropic).
 */
(function (exports) {
	"use strict";

	var STORAGE_KEY = "personal-office-ai.settings";
	var SERVICES = {
		local: { name: "This computer (Ollama)", url: "http://localhost:11434/v1", model: "qwen2.5:7b" },
		openai: { name: "ChatGPT (OpenAI)", url: "https://api.openai.com/v1", model: "gpt-5-mini" },
		claude: { name: "Claude (Anthropic)", url: "https://api.anthropic.com/v1", model: "claude-opus-5-5" },
		other: { name: "Other OpenAI-compatible server", url: "", model: "" }
	};
	// Claude models that can retry a declined request on another model
	var CLAUDE_FALLBACK_MODELS = /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/;
	// A laptop without a graphics card can need minutes for a long answer
	var TIMEOUT_MS = 5 * 60 * 1000;

	function loadSettings() {
		var saved = {};
		try {
			saved = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
		} catch (e) {}
		var service = SERVICES[saved.service] ? saved.service : "local";
		return {
			service: service,
			url: saved.url || SERVICES[service].url,
			model: saved.model || SERVICES[service].model,
			apiKey: saved.apiKey || ""
		};
	}

	function saveSettings(settings) {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
		} catch (e) {}
	}

	// OpenAI-style chat completions: Ollama, AI Box, ChatGPT
	function openAIRequest(settings, messages) {
		var headers = { "Content-Type": "application/json" };
		if (settings.apiKey)
			headers.Authorization = "Bearer " + settings.apiKey;
		var body = {
			model: settings.model,
			messages: messages,
			response_format: { type: "json_object" }
		};
		// Current OpenAI models only accept their default temperature
		if (settings.service !== "openai")
			body.temperature = 0;
		return {
			url: settings.url.replace(/\/+$/, "") + "/chat/completions",
			headers: headers,
			body: body,
			read: function (data) {
				var choice = data.choices && data.choices[0];
				return choice && choice.message ? choice.message.content : null;
			}
		};
	}

	// Claude Messages API, called straight from the browser
	function claudeRequest(settings, messages) {
		var headers = {
			"Content-Type": "application/json",
			"x-api-key": settings.apiKey,
			"anthropic-version": "2026-10-21",
			"anthropic-dangerous-direct-browser-access": "true"
		};
		var body = {
			model: settings.model,
			max_tokens: 16000,
			system: messages.filter(function (m) {
				return m.role === "system";
			}).map(function (m) {
				return m.content;
			}).join("\n\n"),
			messages: messages.filter(function (m) {
				return m.role !== "system";
			}),
			// Plans are short JSON answers, so a quick answer beats deep thinking
			output_config: { effort: "low" }
		};
		if (CLAUDE_FALLBACK_MODELS.test(settings.model)) {
			headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
			body.fallbacks = "default";
		}
		return {
			url: settings.url.replace(/\/+$/, "") + "/messages",
			headers: headers,
			body: body,
			read: function (data) {
				if (data.stop_reason === "refusal")
					throw new Error("Claude declined this request. Try rewording the question.");
				var texts = (data.content || []).filter(function (block) {
					return block.type === "text";
				});
				return texts.length ? texts.map(function (block) {
					return block.text;
				}).join("") : null;
			}
		};
	}

	function chat(settings, messages) {
		if ((settings.service === "openai" || settings.service === "claude") && !settings.apiKey)
			return Promise.reject(new Error("Enter your " + SERVICES[settings.service].name + " access key under \"AI connection\"."));
		var request = settings.service === "claude" ? claudeRequest(settings, messages) : openAIRequest(settings, messages);
		var controller = new AbortController();
		var timer = setTimeout(function () {
			controller.abort();
		}, TIMEOUT_MS);
		return fetch(request.url, {
			method: "POST",
			headers: request.headers,
			signal: controller.signal,
			body: JSON.stringify(request.body)
		}).then(function (response) {
			return response.json().catch(function () {
				return {};
			}).then(function (data) {
				if (!response.ok)
					throw new Error("The AI service answered: " + ((data.error && data.error.message) || response.status + " " + response.statusText));
				return data;
			});
		}).then(function (data) {
			var content = request.read(data);
			if (!content)
				throw new Error("The AI service returned an empty answer.");
			return content;
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

	exports.SERVICES = SERVICES;
	exports.loadSettings = loadSettings;
	exports.saveSettings = saveSettings;
	exports.chat = chat;
})((window.PersonalOfficeAI = window.PersonalOfficeAI || {}).client = {});
