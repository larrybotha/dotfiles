return {
	{
		"epwalsh/obsidian.nvim",
		name = "obsididan.nvim",
		event = "VeryLazy",
		dependencies = { "nvim-lua/plenary.nvim" },
		config = function()
			require("custom.plugins.obsidian")

			-- Open 'everything' obsidian vault
			--  - in terminal mode
			--  - in vertical split
			--  - in a nested Neovim instance
			--  - restoring the most recent session
			--
			-- This allows for quickly getting back to the last location visited in
			-- the obsidian vault, while allowing for navigation inside the project
			-- independent of the Neovim instance from which it was opened
			vim.keymap.set(
				"",
				"<leader>ve",
				":vnew | terminal tmux new-session -A -s everything -c ~/projects/obsidian-vaults/everything/ nvim -c DoTheSession<CR>",
				{ desc = "open 'everything' obsidian vault in vertical split terminal" }
			)

		end,
	},
}
