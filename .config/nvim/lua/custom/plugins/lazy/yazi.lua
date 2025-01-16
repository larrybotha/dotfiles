local function custom_keymappings(yazi_buffer, config, context)
	local openers = require("yazi.openers")
	local keybinding_helpers = require("yazi.keybinding_helpers")
	local key_mappings = require("yazi.config").set_keymappings(yazi_buffer, config, context)

	vim.keymap.set({ "t" }, "<cr>", function()
		keybinding_helpers.select_current_file_and_close_yazi(config, {
			api = context.api,
			on_multiple_files_opened = function(chosen_files)
				local current = vim.api.nvim_get_current_win()

				openers.open_file(chosen_files[1])
				openers.send_files_to_quickfix_list(chosen_files)
				vim.fn.win_gotoid(current)
			end,
			on_file_opened = openers.open_file,
		})
	end, {
		buffer = yazi_buffer,
		desc = "yazi add selected files to quickfix if multiple, open first",
	})

	vim.keymap.set({ "t" }, "<c-t>", function()
		keybinding_helpers.select_current_file_and_close_yazi(config, {
			api = context.api,
			on_multiple_files_opened = function(chosen_files)
				openers.open_file_in_tab(chosen_files[1])

				local current = vim.api.nvim_get_current_win()

				openers.send_files_to_quickfix_list(chosen_files)
				vim.fn.win_gotoid(current)
			end,
			on_file_opened = openers.open_file_in_tab,
		})
	end, {
		buffer = yazi_buffer,
		desc = "yazi add selected files to quickfix if multiple, open first in new tab",
	})

	return key_mappings
end

return {
	"mikavilpas/yazi.nvim",
	event = "VeryLazy",
	dependencies = { { "nvim-lua/plenary.nvim", lazy = true } },
	config = function()
		local yazi = require("yazi")

		yazi.setup({
			set_keymappings_function = custom_keymappings,
			keymaps = {
				grep_in_directory = "<leader>fg",
				open_file_in_tab = false,
				replace_in_directory = false, -- disabled - requires grug-far
			},
		})

		vim.keymap.set("n", "<leader>n", ":Yazi cwd<CR>", { silent = true, desc = "yazi open at cwd" })
		vim.keymap.set("n", "<leader>ff", ":Yazi<CR>", { silent = true, desc = "yazi open at current file's dir" })
	end,
}
