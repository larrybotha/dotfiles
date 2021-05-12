local actions = require('telescope.actions')

local M = {}

require('telescope').setup{
  defaults = {
    mappings = {
      i = {
        ["<esc>"] = actions.close -- close on escape
      },
    },
  },
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
