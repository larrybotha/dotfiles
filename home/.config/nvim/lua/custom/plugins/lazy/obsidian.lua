--- Creates a new split window with a date-prefixed filename in the current directory
---
--- This function constructs a filename starting with the current date (YYYY-MM-DD)
--- in the same directory as the current file, then opens the command line with
--- `:new <current_dir>/<date>-` allowing the user to complete the filename.
---
--- Example: If current file is in ~/notes/, this opens command line with:
---   :new ~/notes/2026-02-19-
local function new_dated_split()
	local current_dir = vim.fn.expand("%:h")
	local date = os.date("%Y-%m-%d")
	local partial_path = current_dir .. "/" .. date .. "-"

	-- Open command line with the partial path and position cursor at the end
	vim.api.nvim_feedkeys(":new " .. partial_path, "n", false)
end

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

			-- Create command for opening dated split
			vim.api.nvim_create_user_command("CustomNewFileDated", new_dated_split, {})

			-- Expand 'obsn' to 'CustomNewFileDated'
			vim.cmd([[cabbrev obsn CustomNewFileDated<CR>]])
		end,
	},
}
