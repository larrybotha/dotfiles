local cc = require("codecompanion")
local spinner = require("custom.plugins.custom-spinner")

cc.setup({
	adapters = {
		acp = {
			claude_code = function()
				return require("codecompanion.adapters").extend("claude_code", {
					env = {
						CLAUDE_CODE_OAUTH_TOKEN = "cmd:pass claude-code/token/neovim",
					},
				})
			end,
		},
	},
	strategies = {
		chat = {
			adapter = "claude_code",
			opts = {
				completion_provider = "blink",
			},
		},
		inline = { adapter = "claude_code" },
		agent = { adapter = "claude_code" },
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
