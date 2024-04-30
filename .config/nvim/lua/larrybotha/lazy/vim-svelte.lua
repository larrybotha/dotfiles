return {
  -- TODO: determine if we need this plugin anymore - vim-polyglot + formatter
  -- should mitigate the need for this plugin
  'evanleck/vim-svelte', branch= 'main',
  init = function()
    vim.g.svelte_preprocessors = {'typescript','scss'}
  end
}
