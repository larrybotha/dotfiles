return {
	"nvim-treesitter/nvim-treesitter",
	build = ":TSUpdate",
	branch = "main",
	lazy = false,

	config = function()
		local group = vim.api.nvim_create_augroup("custom-treesitter", {
			clear = true,
		})

		require("nvim-treesitter").install({
			"bash",
			"c",
			"comment",
			"css",
			"csv",
			"elm",
			"diff",
			"dockerfile",
			"go",
			"git_config",
			"gitignore",
			"gomod",
			"hcl",
			"html",
			"htmldjango",
			"http",
			"hurl",
			"javascript",
			"jsdoc",
			"json",
			"just",
			"lua",
			"make",
			"markdown",
			"nginx",
			"python",
			"regex",
			"rst",
			"rust",
			"scss",
			"sql",
			"svelte",
			"terraform",
			"tmux",
			"toml",
			"typescript",
			"vim",
			"vimdoc",
			"yaml",
		})

		-- explicitly enable syntax highlighting for the following filetypes
		local syntax_on = {}

		vim.api.nvim_create_autocmd("FileType", {
			group = group,
			callback = function(args)
				local bufnr = args.buf
				local ft = vim.bo[bufnr].filetype
				pcall(vim.treesitter.start)

				if syntax_on[ft] then
					vim.bo[bufnr].syntax = "on"
				end
			end,
		})
	end,
}
