local formatter = require("formatter")
local filetypes = require("formatter.filetypes")
local formatters = require("formatter.defaults")

local custom_formatters = require("modules/formatter/custom")

formatter.setup({
	logging = true,
	log_level = vim.log.levels.WARN,

	filetype = {
		go = { custom_formatters.goimports, custom_formatters.gofmt },
		graphql = { custom_formatters.prettierd("graphql") },
		hcl = { custom_formatters.terraform },
		html = { custom_formatters.prettierd("html") },
		htmldjango = { custom_formatters.djlint },
		javascript = { custom_formatters.prettierd(), formatters.eslint_d },
		javascriptreact = { custom_formatters.prettierd(), formatters.eslint_d },
		json = {
			custom_formatters.prettierd("json"),
			custom_formatters.fixjson,
		},
		lua = { filetypes.lua.stylua },
		markdown = {
			custom_formatters.cbfmt,
			-- TODO: determine how to get markdown_toc to update the file without confirmation
			--custom_formatters.markdown_toc,
			custom_formatters.prettierd(),
		},
		org = { custom_formatters.cbfmt },
		packer = { custom_formatters.packer },
		python = {
			custom_formatters.isort,
			custom_formatters.autoimport,
			custom_formatters.black,
		},
		rust = { filetypes.rust.rustfmt },
		sh = {
			custom_formatters.shfmt,
			custom_formatters.shellharden,
		},
		sql = { custom_formatters.sqlfluff },
		svelte = { custom_formatters.prettierd("svelte"), formatters.eslint_d },
		svg = { custom_formatters.prettierd("html") },
		terraform = { custom_formatters.terraform },
		typescript = { custom_formatters.prettierd("typescript"), formatters.eslint_d },
		typescriptreact = { custom_formatters.prettierd(), formatters.eslint_d },
		vue = { custom_formatters.prettierd(), formatters.eslint_d },
		toml = { custom_formatters.taplo },
		yaml = { custom_formatters.prettierd("yaml") },
	},

	["svx"] = { custom_formatters.prettierd() },
})

local au_group = vim.api.nvim_create_augroup("FormatAutogroup", { clear = true })

-- format on save
vim.api.nvim_create_autocmd("BufWritePost", {
	pattern = "*",
	group = au_group,
	command = "FormatWrite",
})
