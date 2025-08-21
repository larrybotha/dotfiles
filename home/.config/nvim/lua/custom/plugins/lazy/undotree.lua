return {
	{
		"mbbill/undotree",
		name = "undotree",
		init = function()
			vim.keymap.set("n", "<leader>u", vim.cmd.UndotreeToggle, { desc = "Toggle undotree" })

			-- Persist undos to system
			-- With undotree allows for undo / redo across Neovim startups
			-- Nvim automatically saves to ~/.local/state/nvim/undo
			vim.opt.undofile = true
		end,
	},
}
