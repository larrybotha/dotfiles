return {
	"nvim-treesitter/nvim-treesitter",
	build = ":TSUpdate",

	config = function()
		require("nvim-treesitter.configs").setup({
			-- one of "all", or a list of languages
			ensure_installed = {
				"bash",
				"comment",
				"css",
				"dockerfile",
				"go",
				"gomod",
				"hcl",
				"html",
				"http",
				"javascript",
				"jsdoc",
				"json",
				"lua",
				"make",
				"markdown",
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
