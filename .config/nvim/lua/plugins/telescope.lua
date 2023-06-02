
local M = {}
local custom_actions = {}

function custom_actions.fzf_multi_select(prompt_bufnr)
	local picker = action_state.get_current_picker(prompt_bufnr)
	local num_selections = table.getn(picker:get_multi_selection())

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

M.custom_find_files = function(opts)
	opts = opts or {}
	-- add hidden files to find_files
	opts.hidden = true

	require('telescope').find_files(opts)
end

M.lazy_config = {
  'nvim-telescope/telescope.nvim',
  lazy=false,

  config = function()
    local telescope = require('telescope')
    local actions = require("telescope.actions")
    local action_state = require("telescope.actions.state")

    telescope.setup({
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

    telescope.load_extension("fzf")
    telescope.load_extension("asynctasks")

    vim.cmd([[
      nnoremap <C-p> :lua require'plugins/telescope'.custom_find_files()<cr>
      nnoremap <leader>fg <cmd>Telescope live_grep<cr>
      nnoremap <leader>fb <cmd>Telescope buffers<cr>
      nnoremap <leader>fh <cmd>Telescope help_tags<cr>
      nnoremap <leader>fa <cmd>Telescope builtin<cr>
      nnoremap <leader>fr :lua require('telescope.builtin').lsp_references({trim_text=true})<cr>
      nnoremap <leader>ft :lua require('telescope').extensions.asynctasks.all()<cr>

      "" Diagnostics
      " list diagnostics in workspace
      nnoremap <leader>fd <cmd>Telescope diagnostics<cr>
      " list diagnostics for current file only
      nnoremap <leader>fD :lua require('telescope.builtin').diagnostics({bufnr=0})<cr>

      highlight link TelescopeMultiSelection Identifier
      highlight link TelescopeMatching Function
    ]])
  end,

  dependencies = {
    'nvim-lua/plenary.nvim',
    'junegunn/fzf',
    'GustavoKatel/telescope-asynctasks.nvim',
    { 'nvim-telescope/telescope-fzf-native.nvim', build = 'cmake -S. -Bbuild -DCMAKE_BUILD_TYPE=Release && cmake --build build --config Release && cmake --install build --prefix build' }
  },
}


return M
