return {
	"voldikss/vim-floaterm",
	name = "floaterm",
	event = "VeryLazy",
	init = function()
		vim.g.floaterm_width = 0.91
		vim.g.floaterm_height = 0.98
		vim.g.floaterm_borderchars = "─│─│╭╮╯╰"
		vim.g.floaterm_keymap_toggle = "<F12>"

		vim.keymap.set("n", "<F12>", ":FloatermToggle<CR>", { silent = true, desc = "open floaterm" })
		vim.keymap.set("t", "<F12>", "<C-\\><C-n>:FloatermToggle<CR>", { silent = true, desc = "close floaterm" })

		vim.api.nvim_set_hl(0, "FloatermBorder", { link = "FloatBorder" })

		local configs = {
			{ trigger = "lzg", command = "lazygit", desc = "open lazygit" },
			{ trigger = "lzn", command = "lazynpm", desc = "open lazynpm" },
			{ trigger = "lzd", command = "lazydocker", desc = "open lazydocker" },
		}

		for _, config in ipairs(configs) do
			if vim.fn.executable(config.command) then
				local mapping = string.format("<leader>%s", config.trigger)
				local command = string.format(":FloatermNew %s<CR>", config.command)

				vim.keymap.set("n", mapping, command, { silent = true, desc = config.desc })
			else
				print(string.format("'%s' command not found", config.command))
			end
		end
	end,
}
