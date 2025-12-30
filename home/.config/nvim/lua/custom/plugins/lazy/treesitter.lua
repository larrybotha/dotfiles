return {
	"nvim-treesitter/nvim-treesitter",
	build = ":TSUpdate",
	branch = "master",
	lazy = false,

	config = function()
		require("nvim-treesitter.configs").setup({
			-- one of "all", or a list of languages
			ensure_installed = {
				"bash",
				"comment",
				"css",
				"diff",
				"dockerfile",
				"go",
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
				"norg",
				"python",
				"regex",
				"rst",
				"rust",
				"scss",
				"sql",
				"svelte",
				"toml",
				"typescript",
				"vim",
				"vimdoc",
				"yaml",
			},
			indent = {
				enable = true,
			},
			-- List of parsers to ignore installing
			--ignore_install = { "javascript" },
			highlight = {
				-- false will disable the whole extension
				enable = true,
				-- list of languages that will be disabled
				disable = {},
			},
		})
	end,
}
