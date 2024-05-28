require("custom.plugins.luasnip")

local cmp = require("cmp")

vim.opt.completeopt = {
	"menu", -- use popup menu to show completion items
	"menuone", -- show popup menu even when there is only 1 item
	"noselect", -- require user to select item explicitly
}
vim.opt.shortmess:append("c") -- don't send messages to ins-completion-menu

cmp.setup({
	snippet = {
		expand = function(args)
			require("luasnip").lsp_expand(args.body)
		end,
	},
	mapping = cmp.mapping.preset.insert({
		["<C-e>"] = cmp.mapping.abort(),
		["<C-x><C-o>"] = cmp.mapping.complete(), -- replace Vim's omnifunc
		["<C-y>"] = cmp.mapping.confirm({ select = true }),
		["<S-Tab>"] = cmp.mapping.select_prev_item(),
		["<Tab>"] = cmp.mapping.select_next_item(),
	}),
	sources = cmp.config.sources({
		-- order matters
		{ name = "nvim_lua" }, -- Neovim lua API
		{ name = "luasnip" },
		{ name = "nvim_lsp" },
		{ name = "nvim_lsp_document_symbol" },
		{ name = "nvim_lsp_signature_help" },
		{ name = "path" },
		{ name = "buffer", keyword_length = 5 },
	}),
})

-- Use buffer source for `/` and `?`
cmp.setup.cmdline({ "/", "?" }, {
	mapping = cmp.mapping.preset.cmdline(),
	sources = {
		{ name = "buffer" },
	},
})

-- Use cmdline & path source for ':'
cmp.setup.cmdline(":", {
	mapping = cmp.mapping.preset.cmdline(),
	sources = cmp.config.sources({
		{ name = "path" },
	}, {
		{ name = "cmdline" },
	}),
})

-- configure dadbod
cmp.setup.filetype({ "sql" }, {
	sources = {
		{ name = "vim-dadbod-completion" },
		{ name = "buffer" },
	},
})
