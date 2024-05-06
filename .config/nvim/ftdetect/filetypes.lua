if vim.g.did_load_filetypes then
	return
end

local group = vim.api.nvim_create_augroup("CustomFiletypeGroup", { clear = true })

vim.api.nvim_create_autocmd({ "BufRead", "BufNewFile" }, {
	group = group,
	desc = [[
    set a consistent filetype for yaml files, including those that don't end
		in .y(a)ml, such as .yml.example etc.
	]],
	pattern = { "*.yml", "*.yml.*", "*.yaml", "*.yaml.*" },
	callback = function()
		vim.bo.filetype = "yaml"
	end,
})
