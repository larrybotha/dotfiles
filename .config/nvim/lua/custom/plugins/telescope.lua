local M = {}
local custom_actions = {}

function custom_actions.fzf_multi_select(prompt_bufnr)
	local actions = require("telescope.actions")
	local action_state = require("telescope.actions.state")

	local picker = action_state.get_current_picker(prompt_bufnr)
	local num_selections = #picker:get_multi_selection()

	if num_selections > 1 then
		-- actions.file_edit throws
		-- see https://github.com/nvim-telescope/telescope.nvim/issues/416#issuecomment-841692272
		--actions.file_edit(prompt_bufnr)
		actions.send_selected_to_qflist(prompt_bufnr)
		actions.open_qflist(prompt_bufnr)
	else
		actions.file_edit(prompt_bufnr)
	end
end

M.setup = function()
	local telescope = require("telescope")
	local builtin = require("telescope.builtin")
	local setKeymap = vim.keymap.set

	telescope.setup({
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
		pickers = {
			live_grep = {
				mappings = {
					n = {
						-- switch to filtering by filename during live_grep
						["<c-f>"] = require("telescope.actions").to_fuzzy_refine,
					},
				},
			},
		},
	})

	require("telescope").load_extension("fzf")
	require("telescope").load_extension("asynctasks")

	setKeymap("n", "<C-p>", function()
		builtin.find_files({ hidden = true })
	end)
	setKeymap("n", "<leader>fg", builtin.live_grep, {})
	setKeymap("n", "<leader>fb", builtin.buffers, {})
	setKeymap("n", "<leader>fh", builtin.help_tags, {})
	setKeymap("n", "<leader>fa", builtin.builtin, {})
	setKeymap("n", "<leader>fr", function()
		builtin.lsp_references({ trim_text = true })
	end)
	setKeymap("n", "<leader>fR", function()
		vim.lsp.buf.references()
	end, { buffer = true }) -- add references to quickfix
	setKeymap("n", "<leader>ft", telescope.extensions.asynctasks.all, {})

	-- Diagnostics
	setKeymap("n", "<leader>fd", builtin.diagnostics, {}) -- all files
	setKeymap("n", "<leader>fD", function()
		builtin.diagnostics({ bufnr = 0 }) -- current file
	end)
end

return M
