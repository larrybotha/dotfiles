return {
	"saghen/blink.cmp",

	dependencies = { "L3MON4D3/LuaSnip", version = "v2.*" },

	version = "1.*",
	opts = {
		snippets = { preset = "luasnip" },
		completion = {
			documentation = {
				auto_show = true,
			},
			ghost_text = { enabled = true },
		},
		sources = {
			default = { "lsp", "path", "snippets", "buffer" },
			per_filetype = {
				sql = { "snippets", "dadbod", "buffer" },
			},
			providers = {
				dadbod = {
					name = "Dadbod",
					module = "vim_dadbod_completion.blink",
				},
				lsp = {
					name = "LSP",
					module = "blink.cmp.sources.lsp",
					transform_items = function(_, items)
						-- exclude keywords from LSP completions
						return vim.tbl_filter(function(item)
							return item.kind ~= require("blink.cmp.types").CompletionItemKind.Keyword
						end, items)
					end,
				},
			},
		},
		fuzzy = { implementation = "prefer_rust_with_warning" },
		signature = { enabled = true },
	},
	opts_extend = { "sources.default" },
}
