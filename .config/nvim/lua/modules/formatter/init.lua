local formatter = require("formatter")
local filetypes = require("formatter.filetypes")
local formatters = require("formatter.defaults")

local custom_formatters = require("modules/formatter/custom")

formatter.setup({
	logging = true,
	log_level = vim.log.levels.WARN,

	filetype = {
		graphql = { formatters.prettierd },
		hcl = { custom_formatters.terraform },
		html = { formatters.prettierd },
		htmldjango = { custom_formatters.djlint },
		javascript = { formatters.prettierd },
		javascriptreact = { formatters.prettierd },
		json = {
			formatters.prettierd,
			custom_formatters.fixjson,
		},
		lua = { filetypes.lua.stylua },
		markdown = { formatters.prettierd, custom_formatters.cbfmt },
		org = { custom_formatters.cbfmt },
		python = {
			custom_formatters.isort,
			custom_formatters.autoimport,
			custom_formatters.black,
		},
		rust = { filetypes.rust.rustfmt },
		sh = { custom_formatters.shfmt },
		sql = { custom_formatters.sqlfluff },
		svelte = { formatters.prettierd },
		svg = { formatters.prettierd },
		terraform = { custom_formatters.terraform },
		typescript = { formatters.prettierd },
		typescriptreact = { formatters.prettierd },
		vue = { formatters.prettierd },
		yaml = { formatters.prettierd },
	},

	["svx"] = { formatters.prettierd },
})

local au_group = vim.api.nvim_create_augroup("FormatAutogroup", { clear = true })
-- format on save
vim.api.nvim_create_autocmd("BufWritePost", {
	pattern = "*",
	group = au_group,
	command = "FormatWrite",
})
