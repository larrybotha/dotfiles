local obsidian = require("obsidian")

local base_options = {}
local vault_dirs = {}
local vaults_dir = "~/projects/obsidian-vaults"

for dir in vim.fs.dir(vaults_dir) do
	local path = vim.fn.expand(string.format("%s/%s", vaults_dir, dir))
	table.insert(vault_dirs, path)
end

local function configure_obsidian(vaults, options)
	local cwd = vim.fn.getcwd()
	local dirs = { cwd }
	local vault_dir = nil
	local vault_map = {}

	for _, dir in pairs(vaults) do
		vault_map[dir] = true
	end

	for x in vim.fs.parents(cwd) do
		table.insert(dirs, x)
	end

	for _, x in pairs(dirs) do
		local is_match = vault_map[x]

		if is_match then
			vault_dir = x
			break
		end
	end

	if vault_dir then
		local workspace_options = vim.tbl_extend("force", options, { dir = vault_dir })

		obsidian.setup(workspace_options)
	end
end

local au_group = vim.api.nvim_create_augroup("ObsidianAutogroup", { clear = true })

vim.api.nvim_create_autocmd("DirChanged", {
	pattern = "*",
	group = au_group,
	callback = function()
		configure_obsidian(vault_dirs, base_options)
	end,
	desc = "Re-initialises Obsidian when the working directory changes",
})

configure_obsidian(vault_dirs, base_options)
