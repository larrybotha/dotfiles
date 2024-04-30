local custom_actions = {}

function custom_actions.fzf_multi_select(prompt_bufnr)
  actions = require("telescope.actions")
  action_state = require("telescope.actions.state")

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

return {
  'nvim-telescope/telescope.nvim',
  branch = '0.1.x',
  dependencies = {
    'nvim-lua/plenary.nvim',
    'GustavoKatel/telescope-asynctasks.nvim',
    {
      'nvim-telescope/telescope-fzf-native.nvim',
      build = 'cmake -S. -Bbuild -DCMAKE_BUILD_TYPE=Release && cmake --build build --config Release && cmake --install build --prefix build',
    }

  },
  opts = {
    defaults = {
      mappings = {
        i = { ["<cr>"] = custom_actions.fzf_multi_select },
        n = { ["<cr>"] = custom_actions.fzf_multi_select },
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
  },
  config = function(_, opts)
    local telescope = require("telescope")
    local builtin = require('telescope.builtin')

    telescope.setup(opts)

    require("telescope").load_extension("fzf")
    require("telescope").load_extension("asynctasks")

    vim.keymap.set('n', '<C-p>', function() builtin.find_files({hidden=true}) end)
    vim.keymap.set('n', '<leader>fg', builtin.live_grep, {})
    vim.keymap.set('n', '<leader>fb', builtin.buffers, {})
    vim.keymap.set('n', '<leader>fh', builtin.help_tags, {})
    vim.keymap.set('n', '<leader>fa', builtin.builtin, {})
    vim.keymap.set('n', '<leader>fr', function() builtin.lsp_references({trim_text=true}) end)
    vim.keymap.set('n', '<leader>ft', telescope.extensions.asynctasks.all, {})

    -- Diagnostics
    vim.keymap.set('n', '<leader>fd', builtin.diagnostics, {}) -- all files
    vim.keymap.set('n', '<leader>fD', function() builtin.diagnostics({bufnr=0}) end) -- current file

    -- highlight link TelescopeMultiSelection Identifier
    -- highlight link TelescopeMatching Function
  end
}
