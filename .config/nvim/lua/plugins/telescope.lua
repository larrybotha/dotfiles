local M = {}

local actions = require("telescope.actions")
local action_state = require("telescope.actions.state")

local custom_actions = {}

function custom_actions.fzf_multi_select(prompt_bufnr)
	local picker = action_state.get_current_picker(prompt_bufnr)
	local num_selections = #picker:get_multi_selection()

	if num_selections > 1 then
		-- actions.file_edit throws
		-- see https://github.com/nvim-telescope/telescope.nvim/issues/416#issuecomment-841692272
		--actions.file_edit(prompt_bufnr)
		actions.send_selected_to_qflist(prompt_bufnr)
		actions.open_qflist()
	else
		actions.file_edit(prompt_bufnr)
	end
end

require("telescope").setup({
	pickers = {
		live_grep = {
			mappings = {
				n = {
					["<c-f>"] = actions.to_fuzzy_refine, -- switch to files filter during live_grep
				},
			},
		},
	},

	defaults = {
		mappings = {
			i = {
				["<cr>"] = custom_actions.fzf_multi_select,
			},
			n = {
				["<cr>"] = custom_actions.fzf_multi_select,
			},
		},
		vimgrep_arguments = {
			"rg",
			"--color=never",
			"--hidden",
			"--no-heading",
			"--with-filename",
			"--line-number",
			"--column",
			"--smart-case",
		},
	},
	extensions = {
		fzf = {
			fuzzy = true,
			override_generic_sorter = true, -- override the generic sorter
			override_file_sorter = true, -- override the file sorter
			case_mode = "smart_case", -- or "ignore_case" or "respect_case"
		},
	},
})

require("telescope").load_extension("fzf")
require("telescope").load_extension("asynctasks")

M.custom_find_files = function(opts)
	opts = opts or {}
	-- add hidden files to find_files
	opts.hidden = true

	require("telescope.builtin").find_files(opts)
end

return M
