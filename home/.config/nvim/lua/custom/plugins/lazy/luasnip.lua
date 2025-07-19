return {
	"L3MON4D3/LuaSnip",
	version = "v2.*",
	build = "make install_jsregexp",
	event = "VeryLazy",
	config = function()
		local ls = require("luasnip")

		vim.snippet.expand = ls.lsp_expand
		vim.snippet.stop = ls.unlink_current

		---@diagnostic disable-next-line: duplicate-set-field
		vim.snippet.active = function(filter)
			filter = filter or {}
			filter.direction = filter.direction or 1

			if filter.direction == 1 then
				return ls.expand_or_jumpable()
			else
				return ls.jumpable(filter.direction)
			end
		end

		---@diagnostic disable-next-line: duplicate-set-field
		vim.snippet.jump = function(direction)
			if direction == 1 then
				if ls.expandable() then
					return ls.expand_or_jump()
				else
					return ls.jumpable(1) and ls.jump(1)
				end
			else
				return ls.jumpable(-1) and ls.jump(-1)
			end
		end

		ls.setup({
			history = true,
			updateevents = "TextChanged,TextChangedI",
			override_builtin = true,
		})

		require("luasnip.loaders.from_lua").lazy_load({ paths = { "~/.config/nvim/lua/custom/snippets" } })

		vim.keymap.set({ "i", "s" }, "<c-k>", function()
			return vim.snippet.active({ direction = 1 }) and vim.snippet.jump(1)
		end, { silent = true, desc = "luasnip jump forward" })

		vim.keymap.set({ "i", "s" }, "<c-j>", function()
			return vim.snippet.active({ direction = -1 }) and vim.snippet.jump(-1)
		end, { silent = true, desc = "luasnip jump backward" })

		--vim.keymap.set({ "i" }, "<C-K>", function()
		--  ls.expand()
		--end, { silent = true })
		--vim.keymap.set({ "i", "s" }, "<C-L>", function()
		--  ls.jump(1)
		--end, { silent = true })
		--vim.keymap.set({ "i", "s" }, "<C-J>", function()
		--  ls.jump(-1)
		--end, { silent = true })
		--vim.keymap.set({ "i", "s" }, "<C-E>", function()
		--  if ls.choice_active() then
		--    ls.change_choice(1)
		--  end
		--end, { silent = true })
	end,
}
