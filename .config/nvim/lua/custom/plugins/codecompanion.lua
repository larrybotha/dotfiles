local cc = require("codecompanion")
local spinner = require("custom.plugins.custom-spinner")

cc.setup({
	adapters = {
		ollamaCodeLlama = function()
			-- Model is useful for:
			-- - inline completions
			return require("codecompanion.adapters").extend("ollama", {
				schema = {
					model = {
						default = "codellama:7b", -- https://ollama.com/library/codellama
					},
				},
			})
		end,
		ollamaQwen = function()
			-- Model is useful for:
			-- - agentic workflows
			return require("codecompanion.adapters").extend("ollama", {
				schema = {
					model = {
						default = "qwen2:7b", -- https://ollama.com/library/qwen2
					},
				},
			})
		end,
		ollamaStarCoder = function()
			-- Model is useful for:
			-- - inline completions
			return require("codecompanion.adapters").extend("ollama", {
				schema = {
					model = {
						default = "starcoder2:7b", -- https://ollama.com/library/starcoder2
					},
				},
			})
		end,
		ollamaGemma = function()
			-- Model is useful for:
			-- - agentic workflows
			return require("codecompanion.adapters").extend("ollama", {
				schema = {
					model = {
						default = "gemma2:9b", -- https://ollama.com/library/gemma2
					},
				},
			})
		end,
		ollamaVicuna = function()
			-- Model is useful for:
			-- - chat
			return require("codecompanion.adapters").extend("ollama", {
				schema = {
					model = {
						default = "vicuna:7b", -- https://ollama.com/library/vicuna
					},
				},
			})
		end,
		ollamaWizardLm2 = function()
			-- Model is useful for:
			-- - chat
			-- - agentic workflows
			return require("codecompanion.adapters").extend("ollama", {
				schema = {
					model = {
						default = "wizardlm2:7b", -- https://ollama.com/library/wizardlm2
					},
				},
			})
		end,
	},
	strategies = {
		chat = {
			adapter = "ollamaWizardLm2",
			opts = {
				completion_provider = "blink",
			},
		},
		inline = { adapter = "ollamaCodeLlama" },
		agent = { adapter = "ollamaQwen" },
	},
	display = {
		chat = {
			show_references = true,
			--show_settings = true,
			show_token_count = true,
		},
	},
	opts = {
		log_level = "ERROR", -- TRACE|DEBUG|ERROR|INFO
	},
})

--vim.keymap.set({ "n", "v" }, "<C-a>", "<cmd>CodeCompanionActions<cr>", { noremap = true, silent = true })
vim.keymap.set({ "n", "v" }, "<leader>a", "<cmd>CodeCompanionChat Toggle<cr>", { noremap = true, silent = true })
vim.keymap.set("v", "ga", "<cmd>CodeCompanionChat Add<cr>", { noremap = true, silent = true })

-- Expand 'cc' into 'CodeCompanion' in the command line
vim.cmd([[cab cc CodeCompanion]])

vim.api.nvim_create_autocmd("User", {
	pattern = {
		"CodeCompanionRequestStarted",
		"CodeCompanionRequestFinished",
	},
	callback = function(args)
		if args.match == "CodeCompanionRequestStarted" then
			spinner.start()
		elseif args.match == "CodeCompanionRequestFinished" then
			spinner.stop()
		end
	end,
})
