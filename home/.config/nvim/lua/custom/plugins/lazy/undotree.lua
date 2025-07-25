return {
	{
		"mbbill/undotree",
		name = "undotree",
		init = function()
			vim.keymap.set("n", "<leader>u", vim.cmd.UndotreeToggle, { desc = "Toggle undotree" })

			-- Persist undos to system
			-- With undotree allows for undo / redo across Neovim startups
			vim.opt.undodir = os.getenv("HOME") .. "/.local/share/nvim/undodir"
			vim.opt.undofile = true
		end,
	},
}
