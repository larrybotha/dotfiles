return {
	"tpope/vim-fugitive",
	name = "vim-fugitive",
	init = function()
		vim.keymap.set(
			"n",
			"<leader>gp",
			"nmap <leader>gp :exec ':git push origin ' . fugitive#head()<cr>",
			{ desc = "Fugitive git push" }
		)
		vim.keymap.set("", "<leader>gs", ":Git<CR>", { silent = true, desc = "Fugitive git status" })
		vim.keymap.set("", "<leader>gci", ":Git commit -am '", { desc = "Fugitive git commit with message" })
		vim.keymap.set("", "<leader>gco", ":Git checkout<space>", { desc = "Fugitive git checkout branch" })

		-- git diff
		--vim.keymap.set("", "<leader>gd", ":Gdiff")
	end,
}
