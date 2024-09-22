vim.g.codeium_no_map_tab = 0

vim.keymap.set("i", "<C-g><C-g>", vim.fn["codeium#Accept"], {
	expr = true,
	silent = true,
	desc = "Codeium accept suggestion",
})
vim.keymap.set("i", "<C-g><C-n>", function()
	return vim.fn["codeium#CycleCompletions"](1)
end, {
	expr = true,
	silent = true,
	desc = "Codeium cycle completions forwards",
})

vim.keymap.set("i", "<C-g><C-p>", function()
	return vim.fn["codeium#CycleCompletions"](-1)
end, {
	expr = true,
	silent = true,
	desc = "Codeium cycle completions backwards",
})

vim.keymap.set("i", "<C-g><C-c>", vim.fn["codeium#Clear"], {
	expr = true,
	silent = true,
	desc = "Codeium clear suggestion",
})
