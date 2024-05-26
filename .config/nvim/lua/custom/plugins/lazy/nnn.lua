return {
	{
		"mcchrish/nnn.vim",
		name = "nnn",
		config = function()
			local nnn = require("nnn")

			nnn.setup({
				command = "nnn -H", -- display hidden files when opened
				set_default_mappings = 0,
				action = {
					-- NOTE: these splits are the same as used in harpoon.lua, and
					-- are the defaults for opening splits via Telescope
					["<c-t>"] = "tab split",
					["<c-v>"] = "vsplit",
					["<c-x>"] = "split",
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
