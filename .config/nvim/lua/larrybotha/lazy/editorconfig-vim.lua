return {
  'editorconfig/editorconfig-vim',
  init = function()
    vim.g.EditorConfig_exclude_patterns = { "fugitive://.\\*" }
  end
}
