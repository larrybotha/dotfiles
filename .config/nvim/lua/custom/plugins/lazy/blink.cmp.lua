return {
	"saghen/blink.cmp",

	dependencies = {
		"folke/lazydev.nvim",
		{
			"L3MON4D3/LuaSnip",
			version = "v2.*",
		},
	},

	version = "1.*",
	opts = {
		snippets = { preset = "luasnip" },
		completion = {
			documentation = {
				auto_show = true,
				window = { border = "single" },
			},
			menu = {
				border = "single",
				draw = {
					columns = {
						{ "label", "label_description", gap = 1 },
						{ "kind_icon", "kind", "source_name", gap = 1 },
					},
				},
			},
		},
		cmdline = {
			completion = {
				menu = { auto_show = true },
				list = { selection = { preselect = false, auto_insert = true } },
			},
		},
		keymap = {
			preset = "enter",
			["<Tab>"] = { "select_next", "fallback" },
			["<S-Tab>"] = { "select_prev", "fallback" },
		},
		sources = {
			min_keyword_length = 2,
			default = { "lazydev", "lsp", "path", "snippets", "buffer" },
			per_filetype = {
				sql = { "snippets", "dadbod", "buffer" },
				lua = { inherit_defaults = true, "lazydev" },
			},
			providers = {
				dadbod = {
					name = "Dadbod",
					module = "vim_dadbod_completion.blink",
				},
				lazydev = {
					name = "LazyDev",
					module = "lazydev.integrations.blink",
					-- make lazydev completions top priority (see `:h blink.cmp`)
					score_offset = 100,
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
		fuzzy = {
			implementation = "prefer_rust_with_warning",
			sorts = {
				-- deprioritise emmet when matching
				function(a, b)
					if (a.client_name == nil or b.client_name == nil) or (a.client_name == b.client_name) then
						return
					end

					return b.client_name == "emmet_ls"
				end,
				-- defaults
				"score",
				"sort_text",
			},
		},
		signature = { enabled = true, window = { border = "single" } },
	},
	opts_extend = { "sources.default" },
}
