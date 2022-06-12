'use strict';

const prefix = /^npm/i;

const main = () => {
  const npmVars = [], others = [];

  for (const name in process.env) {
    if (prefix.test(name)) {
      npmVars.push(name);
    } else {
      others.push(name);
    }
  }
  npmVars.sort();
  others.sort();

  console.log('# NPM environment variables');
  console.log('| Name | Value |');
  console.log('|------|-------|');
  npmVars.forEach(name => console.log('|', name, '|', process.env[name], '|'));

  console.log('\n# Other environment variables');
  console.log('| Name | Value |');
  console.log('|------|-------|');
  others.forEach(name => console.log('|', name, '|', process.env[name], '|'));
};

main();
