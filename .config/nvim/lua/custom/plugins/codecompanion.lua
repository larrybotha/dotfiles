local cc = require("codecompanion")
local spinner = require("custom.plugins.custom-spinner")

cc.setup({
	adapters = {
		anthropic = function()
			return require("codecompanion.adapters").extend("anthropic", {
				env = {
					api_key = "cmd:op read op://74zuuubvmlx7y4jjnbtbqwsxkm/mokqdt3ctcqope2l5h76nkkgte/credential --no-newline",
				},
			})
		end,
	},
	strategies = {
		chat = {
			adapter = "anthropic",
		},
		inline = {
			adapter = "anthropic",
		},
	},
	display = {
		chat = {
			show_references = true,
			show_token_count = true,
		},
	},
})

vim.keymap.set({ "n", "v" }, "<C-a>", "<cmd>CodeCompanionActions<cr>", { noremap = true, silent = true })
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
