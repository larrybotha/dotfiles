local actions = require('telescope.actions')
local action_state = require("telescope.actions.state")

local M = {}
local custom_actions = {}

require('telescope').setup{
  defaults = {
    mappings = {
      i = {
        ["<esc>"] = actions.close -- close on escape
      },
    },
  },
function custom_actions.fzf_multi_select(prompt_bufnr, mode)
    local picker = action_state.get_current_picker(prompt_bufnr)
    local num_selections = table.getn(picker:get_multi_selection())

    if num_selections > 1 then
	-- actions.file_edit throws - context of picker seems to change
	--actions.file_edit(prompt_bufnr)
	actions.send_selected_to_qflist(prompt_bufnr)
	actions.open_qflist()
    else
	actions.file_edit(prompt_bufnr)
    end
end

require("telescope").setup {
    defaults = {
	mappings = {
	    i = {
		-- close on escape
		["<esc>"] = actions.close,
		["<tab>"] = actions.toggle_selection + actions.move_selection_next,
		["<s-tab>"] = actions.toggle_selection + actions.move_selection_previous,
		["<cr>"] = custom_actions.fzf_multi_select
	    },
	    n = {
		["<tab>"] = actions.toggle_selection + actions.move_selection_next,
		["<s-tab>"] = actions.toggle_selection + actions.move_selection_previous,
		["<cr>"] = custom_actions.fzf_multi_select
	    }
	}
    }
}

-- add hidden files to find_files
M.custom_find_files = function(opts)
  opts = opts or {}

  opts.hidden = true
  opts.find_command = {
    "rg",
    "--files",
    "--hidden",
    "--no-heading",
    "--with-filename",
    "--line-number",
    "--column",
    "--smart-case",
    "--color=never",
  }

  require'telescope.builtin'.find_files(opts)
end

return M
