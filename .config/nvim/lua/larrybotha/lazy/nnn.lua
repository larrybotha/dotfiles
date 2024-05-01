return {
	{
		"mcchrish/nnn.vim",
		name = "nnn",
		config = function()
			nnn = require("nnn")

			nnn.setup({
				command = "nnn -H", -- display hidden files when opened
				set_default_mappings = 0,
				action = {
					["<c-s>"] = "split", -- TODO: fix this; command is swallowed by tmux
					["<c-t>"] = "tab split",
					["<c-v>"] = "vsplit",
				},
				layout = {
					window = {
						height = 0.6,
						highlight = "Debug",
						width = 0.9,
					},
				},
			})

			-- open n³
			vim.keymap.set("n", "<leader>n", ":NnnPicker<CR>", { silent = true })

			-- open n³ in the current file's directory
			vim.keymap.set("n", "<leader>ff", ":NnnPicker %:p:h<CR>", { silent = true })
		end,
	},
}
