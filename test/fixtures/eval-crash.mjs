// Stand-in eval child that dies without a result line.
process.stderr.write("simulated eval child crash\n");
process.exit(7);
