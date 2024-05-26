local M = {}

local function get_workspaces(vaults_dir)
	local child_dirs = {}
	local workspaces = {}

	for dir in vim.fs.dir(vaults_dir) do
		local path = vim.fn.expand(string.format("%s/%s", vaults_dir, dir))
		table.insert(child_dirs, path)
	end

	for _, dir in pairs(child_dirs) do
		local path_parts = {}

		for x in string.gmatch(dir, "[^/]+") do
			table.insert(path_parts, x)
		end

		table.insert(workspaces, {
			name = path_parts[#path_parts],
			path = dir,
		})
	end

	return workspaces
end

M.setup = function()
	local obsidian = require("obsidian")

	local vaults_dir = "~/projects/obsidian-vaults"
	local workspaces = get_workspaces(vaults_dir)
	local options = {
		disable_frontmatter = true, -- don't manage frontmatter
		mappings = {
			-- navigate to markdown files using gf - overrides Vim's default behaviour
			["gf"] = {
				action = function()
					return require("obsidian").util.gf_passthrough()
				end,
				opts = { noremap = false, expr = true, buffer = true },
			},
		},
		workspaces = workspaces,
	}

	if #workspaces > 0 then
		-- TODO: use an autocommand to set this when opening markdown files
		-- see https://github.com/epwalsh/obsidian.nvim#concealing-characters
		vim.opt_local.conceallevel = 1

		obsidian.setup(options)
	end
end

return M
