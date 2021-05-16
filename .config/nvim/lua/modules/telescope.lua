local actions = require("telescope.actions")
local action_state = require("telescope.actions.state")

local M = {}
local custom_actions = {}

function custom_actions.fzf_multi_select(prompt_bufnr)
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
                ["<esc>"] = actions.close
            }
        }
    },
    extensions = {
        fzf = {
            override_generic_sorter = true, -- override the generic sorter
            override_file_sorter = true, -- override the file sorter
            case_mode = "smart_case" -- or "ignore_case" or "respect_case"
        }
    }
}

require("telescope").load_extension("fzf")
require("telescope").load_extension("asynctasks")

M.custom_find_files = function(opts)
    opts = opts or {}
    -- add hidden files to find_files
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
        "--color=never"
    }
    opts.attach_mappings = function(_, map)
        map("i", "<cr>", custom_actions.fzf_multi_select)
        map("n", "<cr>", custom_actions.fzf_multi_select)

        return true
    end

    require "telescope.builtin".find_files(opts)
end

return M
