return {
	"voldikss/vim-floaterm",
	name = "floaterm",
	init = function()
		vim.g.floaterm_width = 0.91
		vim.g.floaterm_height = 0.98
		vim.g.floaterm_borderchars = "─│─│╭╮╯╰"
		vim.g.floaterm_keymap_toggle = "<F12>"

		vim.keymap.set("n", "<F12>", ":FloatermToggle<CR>", { silent = true }) -- open floaterm
		vim.keymap.set("t", "<F12>", "<C-\\><C-n>:FloatermToggle<CR>", { silent = true }) -- close floaterm

		configs = {
		vim.api.nvim_set_hl(0, "FloatermBorder", { link = "FloatBorder" })

			{ trigger = "lzg", command = "lazygit" },
			{ trigger = "lzn", command = "lazynpm" },
			{ trigger = "lzd", command = "lazydocker" },
		}

		for _, config in ipairs(configs) do
			if vim.fn.executable(config.command) then
				mapping = string.format("<leader>%s", config.trigger)
				command = string.format(":FloatermNew %s<CR>", config.command)

				vim.keymap.set("n", mapping, command, { silent = true })
			else
				print(string.format("'%s' command not found", config.command))
			end
		end
	end,
}
