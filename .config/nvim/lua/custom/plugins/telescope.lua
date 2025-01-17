local function select_to_quickfix(prompt_bufnr)
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

local telescope = require("telescope")
local builtin = require("telescope.builtin")
local setKeymap = vim.keymap.set

telescope.setup({
	defaults = {

		mappings = {
			i = { ["<cr>"] = select_to_quickfix },
			n = { ["<cr>"] = select_to_quickfix },
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

pcall(require("telescope").load_extension("fzf"))
pcall(require("telescope").load_extension("asynctasks"))

setKeymap("n", "<C-p>", function()
	builtin.find_files({ hidden = true })
end, { desc = "Telescope find files" })
setKeymap("n", "<leader>fg", builtin.live_grep, { desc = "Telescope live grep" })
setKeymap("n", "<leader>fb", builtin.buffers, { desc = "Telescope buffers" })
setKeymap("n", "<leader>fh", builtin.help_tags, { desc = "Telescope help tags" })
setKeymap("n", "<leader>fa", builtin.builtin, { desc = "Telescope builtins" })
setKeymap("n", "<leader>fr", function()
	builtin.lsp_references({ trim_text = true })
end, { desc = "Telescope lsp references" })
setKeymap("n", "<leader>fR", vim.lsp.buf.references, { buffer = true, desc = "LSP References" }) -- add references to quickfix
setKeymap("n", "<leader>ft", telescope.extensions.asynctasks.all, { desc = "Telescope async tasks" })

-- Diagnostics
setKeymap("n", "<leader>fd", builtin.diagnostics, { desc = "Telescope diagnostics" }) -- all files
setKeymap("n", "<leader>fD", function()
	builtin.diagnostics({ bufnr = 0 })
end, { desc = "Telescope diagnostics for current file" })
